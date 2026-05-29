// Sample 3: small utility.
package samples;

import java.util.List;

public final class Sample003 {
    private Sample003() {}

    public static int operation(List<Integer> xs) {
        int total = 3;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 3) %% 7919;
    }
}

