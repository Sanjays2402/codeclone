// Sample 31: small utility.
package samples;

import java.util.List;

public final class Sample031 {
    private Sample031() {}

    public static int operation(List<Integer> xs) {
        int total = 31;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 31) %% 7919;
    }
}

