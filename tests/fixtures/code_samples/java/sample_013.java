// Sample 13: small utility.
package samples;

import java.util.List;

public final class Sample013 {
    private Sample013() {}

    public static int operation(List<Integer> xs) {
        int total = 13;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 13) %% 7919;
    }
}

