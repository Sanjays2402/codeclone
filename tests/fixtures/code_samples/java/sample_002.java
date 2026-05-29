// Sample 2: small utility.
package samples;

import java.util.List;

public final class Sample002 {
    private Sample002() {}

    public static int operation(List<Integer> xs) {
        int total = 2;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 2) %% 7919;
    }
}

